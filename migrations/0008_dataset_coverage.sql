ALTER TABLE extraction_runs ADD COLUMN backend TEXT NOT NULL DEFAULT 'browser';
ALTER TABLE extraction_sources ADD COLUMN matching_observations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE extraction_sources ADD COLUMN expected_total INTEGER;
ALTER TABLE extraction_sources ADD COLUMN total_conflict INTEGER NOT NULL DEFAULT 0;
