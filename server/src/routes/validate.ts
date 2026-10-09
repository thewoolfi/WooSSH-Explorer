import type { Request } from 'express';
import type { z } from 'zod';

import { badRequest } from '../errors.js';

export interface IssueDetail {
  path: (string | number)[];
  message: string;
  code: string;
}

/** Flattens a zod failure into the `details.issues` array of a `400 BAD_REQUEST`. */
export function issuesOf(error: z.ZodError): IssueDetail[] {
  return error.issues.map((issue) => ({
    path: [...issue.path] as (string | number)[],
    message: issue.message,
    code: issue.code,
  }));
}

export function badRequestFromZod(error: z.ZodError, what = 'body'): never {
  const issues = issuesOf(error);
  const first = issues[0];
  const where = first !== undefined && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  throw badRequest(`Invalid ${what}${where}: ${first?.message ?? 'validation failed'}.`, { issues });
}

/** Parses and narrows a JSON body, or throws `400 BAD_REQUEST` with the issue paths. */
export function parseBody<T extends z.ZodType>(schema: T, req: Request): z.output<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) badRequestFromZod(result.error, 'body');
  return result.data;
}

/** Parses and narrows a query string, or throws `400 BAD_REQUEST` with the issue paths. */
export function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.output<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) badRequestFromZod(result.error, 'query');
  return result.data;
}

/** Parses and narrows route params. */
export function parseParams<T extends z.ZodType>(schema: T, req: Request): z.output<T> {
  const result = schema.safeParse(req.params);
  if (!result.success) badRequestFromZod(result.error, 'path');
  return result.data;
}
