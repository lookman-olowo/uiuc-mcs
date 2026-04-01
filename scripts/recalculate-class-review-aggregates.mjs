#!/usr/bin/env node

import { loadAccessToken, loadProjectId } from './lib/firebase-cli-auth.mjs';

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = await loadProjectId();
const ACCESS_TOKEN = await loadAccessToken();

const [classes, reviews] = await Promise.all([
  listCollectionDocs('Class'),
  listCollectionDocs('Reviews'),
]);

const reviewsByCourse = new Map();
for (const review of reviews) {
  const key = review.course;
  if (!key) {
    continue;
  }
  const bucket = reviewsByCourse.get(key) || [];
  bucket.push(review);
  reviewsByCourse.set(key, bucket);
}

const stale = [];

for (const classDoc of classes) {
  const related = reviewsByCourse.get(classDoc.ClassName) || [];
  const count = related.length;
  const aggregates = {
    RatingCount: count,
    DifficultyCount: count,
    WorkloadCount: count,
    RatingAvg: count ? average(related, 'rating') : 0,
    DifficultyAvg: count ? average(related, 'difficulty') : 0,
    WorkloadAvg: count ? average(related, 'workload') : 0,
  };

  const changedFields = Object.keys(aggregates).filter(
    (field) => !isEqual(Number(classDoc[field] || 0), aggregates[field]),
  );

  if (changedFields.length) {
    stale.push({ classDoc, aggregates, changedFields });
  }
}

console.log(`Project: ${PROJECT_ID}`);
console.log(`Class docs: ${classes.length}`);
console.log(`Review docs: ${reviews.length}`);
console.log(`Classes needing aggregate repair: ${stale.length}`);

for (const item of stale) {
  console.log(
    `stale ${item.classDoc.CourseNumber} - ${item.classDoc.ClassName} [${item.changedFields.join(', ')}]`,
  );
}

if (!APPLY) {
  console.log('Dry run only. Re-run with --apply to patch stale aggregate fields.');
  process.exit(0);
}

for (const item of stale) {
  const params = new URLSearchParams();
  for (const field of item.changedFields) {
    params.append('updateMask.fieldPaths', field);
  }

  const response = await firestoreRequest(
    `/documents/Class/${item.classDoc.id}?${params.toString()}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeFields(item.aggregates) }),
    },
  );

  console.log(`updated ${item.classDoc.CourseNumber} - ${item.classDoc.ClassName} -> ${response.name}`);
}

async function listCollectionDocs(collectionName) {
  const docs = [];
  let pageToken = '';

  while (true) {
    const query = new URLSearchParams({ pageSize: '500' });
    if (pageToken) {
      query.set('pageToken', pageToken);
    }

    const response = await firestoreRequest(`/documents/${collectionName}?${query.toString()}`);
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

async function firestoreRequest(resource, options = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)${resource}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
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

function average(items, field) {
  return items.reduce((sum, item) => sum + Number(item[field] || 0), 0) / items.length;
}

function encodeFields(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, encodeValue(value)]),
  );
}

function encodeValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
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
  if ('timestampValue' in value) {
    return value.timestampValue;
  }
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map((item) => decodeValue(item));
  }
  if ('mapValue' in value) {
    return decodeFields(value.mapValue.fields || {});
  }
  return value;
}

function isEqual(left, right) {
  return Math.abs(left - right) < 1e-9;
}
