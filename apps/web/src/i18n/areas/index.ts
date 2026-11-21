/** Customer-dashboard copy split by area; spread into ../es.ts and ../en.ts. */
import { connectEn, connectEs } from './connect';
import { teamEn, teamEs } from './team';
import { shellEn, shellEs } from './shell';
import { usageEn, usageEs } from './usage';
import { chatEn, chatEs } from './chat';
import { createEn, createEs } from './create';
import { controlEn, controlEs } from './control';

export const areasEs = { ...connectEs, ...teamEs, ...shellEs, ...usageEs, ...chatEs, ...createEs, ...controlEs } as const;
export const areasEn: Record<keyof typeof areasEs, string> = { ...connectEn, ...teamEn, ...shellEn, ...usageEn, ...chatEn, ...createEn, ...controlEn };
