-- Migration 0002: RAG chunks (embeddings for semantic codebase search)
CREATE TABLE IF NOT EXISTS `rag_chunks` (
  `id` text PRIMARY KEY NOT NULL,
  `file_path` text NOT NULL,
  `chunk_index` integer NOT NULL,
  `content` text NOT NULL,
  `embedding` blob,
  `indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rag_chunks_file_path_idx` ON `rag_chunks` (`file_path`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rag_chunks_file_chunk_idx` ON `rag_chunks` (`file_path`, `chunk_index`);
