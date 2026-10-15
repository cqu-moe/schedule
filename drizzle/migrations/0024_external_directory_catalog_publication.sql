-- Core directories have their own publication pointer. A complete pre-0024
-- generation can still seed that pointer while teacher harvesting is deferred.
ALTER TABLE external_directory_state ADD COLUMN catalog_run_id TEXT;
UPDATE external_directory_state
SET catalog_run_id=published_run_id
WHERE catalog_run_id IS NULL;
