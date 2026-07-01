-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "topic" TEXT NOT NULL DEFAULT 'tech';

-- CreateIndex
CREATE INDEX "Article_topic_idx" ON "Article"("topic");
