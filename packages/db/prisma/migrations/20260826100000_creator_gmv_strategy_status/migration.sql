-- GMV-All rows are retained as history but can be explicitly retired by the
-- Creator Database strategy without being mistaken for provider failures.
ALTER TYPE "CreatorSearchPartitionStatus" ADD VALUE IF NOT EXISTS 'DISABLED_BY_STRATEGY';
