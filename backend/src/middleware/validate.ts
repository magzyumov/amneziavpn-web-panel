import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

// Express middleware-фабрика для валидации req.body через zod-схему.
// Если данные валидны — req.body заменяется на parsed (с применёнными default'ами).
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue.path.join('.');
      res.status(400).json({ error: `${path || 'body'}: ${issue.message}` });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
