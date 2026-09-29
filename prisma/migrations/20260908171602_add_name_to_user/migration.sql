-- AlterTable
ALTER TABLE "User" ADD COLUMN     "name" TEXT;

-- Backfill existing row(s) before enforcing NOT NULL
UPDATE "User" SET "name" = 'Chima Worlu' WHERE email = 'chimasolomon00@gmail.com';

-- Enforce NOT NULL now that all rows have a value
ALTER TABLE "User" ALTER COLUMN "name" SET NOT NULL;
