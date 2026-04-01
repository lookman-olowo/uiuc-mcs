#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAccessToken, loadProjectId } from './lib/firebase-cli-auth.mjs';

const options = parseArgs(process.argv.slice(2));
const projectId = await loadProjectId(options.project);
const accessToken = await loadAccessToken();
const sourcePath = path.resolve(process.cwd(), options.source);
const desiredDocs = await loadDefinitions(sourcePath);
const existingDocs = await listCollectionDocs(projectId, accessToken, options.collection);

const existingByKey = new Map(
  existingDocs
    .filter((doc) => doc.CourseNumber && doc.ClassName)
    .map((doc) => [courseKey(doc), doc]),
);

const missing = [];
const stale = [];
const unchanged = [];

for (const desired of desiredDocs) {
  const existing = existingByKey.get(courseKey(desired));
  if (!existing) {
    missing.push(desired);
    continue;
  }

  const changedFields = getChangedFields(existing, desired);
  if (changedFields.length) {
    stale.push({ existing, desired, changedFields });
  } else {
    unchanged.push(desired);
  }
}

console.log(`Project: ${projectId}`);
console.log(`Collection: ${options.collection}`);
console.log(`Source: ${path.relative(process.cwd(), sourcePath)}`);
console.log(`Existing docs: ${existingDocs.length}`);
console.log(`Targets: ${desiredDocs.length}`);
console.log(`Missing: ${missing.length}`);
console.log(`Needs update: ${stale.length}`);
console.log(`Unchanged: ${unchanged.length}`);

for (const doc of missing) {
  console.log(`missing ${doc.CourseNumber} - ${doc.ClassName}`);
}
for (const item of stale) {
  console.log(`stale   ${item.desired.CourseNumber} - ${item.desired.ClassName} [${item.changedFields.join(', ')}]`);
}
for (const doc of unchanged) {
  console.log(`ok      ${doc.CourseNumber} - ${doc.ClassName}`);
}

if (!options.apply) {
  console.log('Dry run only. Re-run with --apply to create missing docs.');
  if (stale.length && !options.updateExisting) {
    console.log('Add --update-existing to patch docs whose metadata differs from the source file.');
  }
  process.exit(0);
}

for (const doc of missing) {
  const response = await firestoreRequest(projectId, accessToken, `/documents/${options.collection}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(doc) }),
  });
  console.log(`created ${doc.CourseNumber} - ${doc.ClassName} -> ${response.name}`);
}

if (options.updateExisting) {
  for (const item of stale) {
    const params = new URLSearchParams();
    for (const field of item.changedFields) {
      params.append('updateMask.fieldPaths', field);
    }

    const response = await firestoreRequest(
      projectId,
      accessToken,
      `/documents/${options.collection}/${item.existing.id}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: encodeFields(item.desired) }),
      },
    );

    console.log(`updated ${item.desired.CourseNumber} - ${item.desired.ClassName} -> ${response.name}`);
  }
}

async function loadDefinitions(sourceFile) {
  const module = await import(pathToFileURL(sourceFile).href);
  const docs = module.default ?? module.docs ?? module.courses;
  if (!Array.isArray(docs) || !docs.length) {
    throw new Error(`No course definitions exported from ${sourceFile}`);
  }
  return docs;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    updateExisting: false,
    collection: 'Class',
    project: '',
    source: 'scripts/course-definitions/issue-16.mjs',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--apply':
        options.apply = true;
        break;
      case '--update-existing':
        options.updateExisting = true;
        break;
      case '--collection':
        options.collection = argv[++i];
        break;
      case '--project':
        options.project = argv[++i];
        break;
      case '--source':
        options.source = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function listCollectionDocs(projectId, accessToken, collection) {
  const docs = [];
  let pageToken = '';

  while (true) {
    const query = new URLSearchParams({ pageSize: '200' });
    if (pageToken) {
      query.set('pageToken', pageToken);
    }

    const response = await firestoreRequest(
      projectId,
      accessToken,
      `/documents/${collection}?${query.toString()}`,
    );

    const pageDocs = (response.documents || []).map((doc) => ({
      id: doc.name?.split('/').pop() || '',
      ...decodeFields(doc.fields || {}),
    }));

    docs.push(...pageDocs);
    if (!response.nextPageToken) {
      return docs;
    }
    pageToken = response.nextPageToken;
  }
}

async function firestoreRequest(projectId, accessToken, resource, options = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)${resource}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Firestore API ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

function getChangedFields(existing, desired) {
  const changed = [];
  for (const [key, desiredValue] of Object.entries(toComparableRecord(desired))) {
    const existingValue = toComparableValue(existing[key]);
    if (!isEqual(existingValue, desiredValue)) {
      changed.push(key);
    }
  }
  return changed;
}

function toComparableRecord(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, toComparableValue(value)]),
  );
}

function toComparableValue(value) {
  if (value && typeof value === 'object' && '__fire_int' in value) {
    return Number(value.__fire_int);
  }
  if (value && typeof value === 'object' && '__fire_double' in value) {
    return Number(value.__fire_double);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toComparableValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, toComparableValue(value[key])]),
    );
  }
  return value;
}

function isEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function encodeFields(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, encodeValue(value)]),
  );
}

function encodeValue(value) {
  if (value && typeof value === 'object' && '__fire_int' in value) {
    return { integerValue: String(value.__fire_int) };
  }

  if (value && typeof value === 'object' && '__fire_double' in value) {
    return { doubleValue: value.__fire_double };
  }

  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => encodeValue(item)) } };
  }

  if (value === null) {
    return { nullValue: null };
  }

  if (typeof value === 'string') {
    return { stringValue: value };
  }

  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }

  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }

  if (typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value) } };
  }

  throw new Error(`Unsupported Firestore value: ${value}`);
}

function decodeFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]),
  );
}

function decodeValue(value) {
  if ('stringValue' in value) {
    return value.stringValue;
  }
  if ('integerValue' in value) {
    return Number(value.integerValue);
  }
  if ('doubleValue' in value) {
    return Number(value.doubleValue);
  }
  if ('booleanValue' in value) {
    return value.booleanValue;
  }
  if ('nullValue' in value) {
    return null;
  }
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map((item) => decodeValue(item));
  }
  if ('mapValue' in value) {
    return decodeFields(value.mapValue.fields || {});
  }
  if ('timestampValue' in value) {
    return value.timestampValue;
  }
  return value;
}

function courseKey(course) {
  return `${course.CourseNumber}::${course.ClassName}`;
}
