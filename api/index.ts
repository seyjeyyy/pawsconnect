// Vercel serverless entry point. Every /api/* request is routed here (see
// vercel.json) and handled by the same Express app used in development.
import { createApp } from '../server/src/app.js';

export default createApp();
