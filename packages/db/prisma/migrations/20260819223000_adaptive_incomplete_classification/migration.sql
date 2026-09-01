-- Branch classifications are terminal scheduling metadata. Partial, paused,
-- retrying, or otherwise unfinished searches must not be labeled dead from an
-- intermediate yield snapshot.
UPDATE "CreatorSearchPartition"
SET "branchClassification" = 'UNCLASSIFIED'::"CreatorBranchClassification"
WHERE status IN ('QUEUED', 'STARTING', 'RUNNING', 'WAITING_RETRY', 'PAUSED', 'ERROR')
  AND "observedSaturationState" = 'UNKNOWN';
