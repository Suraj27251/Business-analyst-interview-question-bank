'use strict';

// Server-side database access. Uses the Neon serverless driver (HTTP) which is
// designed for Vercel Functions' short-lived, potentially high-concurrency
// execution model. The connection string is read from the server-only
// DATABASE_URL environment variable and is never exposed to the browser.

const { neon } = require('@neondatabase/serverless');

let cachedSql = null;
let cachedUrl = null;
let testSql = null;

class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('Database is not configured');
    this.name = 'DatabaseNotConfiguredError';
    this.code = 'DB_NOT_CONFIGURED';
    this.statusCode = 503;
  }
}

function isDatabaseConfigured() {
  return Boolean(testSql || process.env.DATABASE_URL);
}

function getSql() {
  if (testSql) return testSql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new DatabaseNotConfiguredError();
  if (!cachedSql || cachedUrl !== url) {
    cachedSql = neon(url);
    cachedUrl = url;
  }
  return cachedSql;
}

// Test helpers: allows unit tests to inject a fake tagged-template `sql`.
function setSqlForTests(sql) {
  testSql = sql;
}

function resetForTests() {
  testSql = null;
  cachedSql = null;
  cachedUrl = null;
}

module.exports = {
  getSql,
  isDatabaseConfigured,
  setSqlForTests,
  resetForTests,
  DatabaseNotConfiguredError,
};
