-- DropIndex
DROP INDEX "messages_search";

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "search_vector" DROP DEFAULT;
