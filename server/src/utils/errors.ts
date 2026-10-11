import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
// The Supabase client is used without generated database types, so rows are
// untyped here; pass T at the call site where a shape matters. Callers that use
// maybeSingle() still null-check the result themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assertDb<T = any>(result: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (result.error) {
    const { code, message } = result.error;
    if (['PGRST202', 'PGRST204', 'PGRST205', '42P01', '42703', '42883'].includes(code || '')) {
      console.error('Database schema does not match this release:', code);
      throw new ApiError(503, 'DEPLOYMENT_SCHEMA_MISMATCH', 'This update is waiting for a database upgrade. Please contact the site administrator; retrying or signing in again will not fix it.');
    }
    if (code === 'PGRST116') throw new ApiError(404, 'NOT_FOUND', 'This record was not found.');
    if (code === '23505') throw new ApiError(409, 'DUPLICATE', 'This record already exists.');
    if (code === '42501') throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action.');
    if (code === 'P0001' || code === '23514' || code === '22023') {
      throw new ApiError(409, 'BUSINESS_RULE', message);
    }
    if (code === '23503') throw new ApiError(400, 'INVALID_REFERENCE', 'A referenced record does not exist or is still in use.');
    console.error('Database operation failed:', code || 'unknown');
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'The database could not complete this request. Please try again.');
  }
  return result.data as T;
}
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Please check the highlighted details.', details: error.flatten() } });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body must contain valid JSON.' } });
    return;
  }
  console.error('Unhandled API failure:', error instanceof Error ? error.name : 'Unknown');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
};
