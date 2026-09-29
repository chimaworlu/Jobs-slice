import { z } from 'zod';

export const sendEmailPayloadSchema = z.object({
  to: z.string('A valid recipient email is required').email('A valid recipient email is required'),
  subject: z.string('Subject is required').min(1, 'Subject is required'),
  html: z.string('HTML body is required').min(1, 'HTML body is required'),
});

export const enqueueJobSchema = sendEmailPayloadSchema.extend({
  idempotencyKey: z.string('idempotencyKey is required').min(1, 'idempotencyKey is required'),
});

export type SendEmailPayload = z.infer<typeof sendEmailPayloadSchema>;
