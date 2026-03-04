# Design: Validate Empty Keyword in Search Endpoint

**Issue:** #35
**Date:** 2026-03-04
**Priority:** P3

## Problem

`GET /api/v1/search` accepts empty `keyword` parameter, causing unnecessary upstream CQU API calls that waste subrequest quota.

## Solution

Add `!keyword.trim()` check before the existing length validation in `src/routes/explore.ts`, returning `400 { detail: "keyword is required" }`.

No change to `source_type` validation — the existing `default` switch branch already returns 400 for invalid/empty values.

## Changes

- `src/routes/explore.ts`: Add empty keyword guard (1 conditional)
- Test: Verify empty/whitespace keyword returns 400
