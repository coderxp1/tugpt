/** Customer-dashboard copy split by area; spread into ../es.ts and ../en.ts. */
import { connectEn, connectEs } from './connect';

export const areasEs = { ...connectEs } as const;
export const areasEn: Record<keyof typeof areasEs, string> = { ...connectEn };
