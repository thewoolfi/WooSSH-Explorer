/**
 * `@types/yazl` types `ZipFile.outputStream` as `NodeJS.ReadableStream`, which lacks the
 * `Readable`/`Writable` surface this server uses (the archive is piped to the HTTP response and
 * must be tearable on cancellation). This file exists only to document that gap — the narrowing
 * cast lives at the single usage site in `transfers/TransferManager.ts`.
 */
export {};
