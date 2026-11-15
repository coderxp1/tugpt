import { createCalendarFindAvailabilityTool } from './google-calendar-tool.js';
import { createOutlookFindAvailabilityTool } from './outlook-calendar-tool.js';
import type { ConnectTool } from './types.js';

/**
 * The built-in calendar tools the chat can register (Google + Outlook). Both
 * share modelName `calendar_find_availability` but differ in provider, so the
 * runtime picks the right one from the user's @-selection.
 */
export function createBuiltInCalendarTools(): ConnectTool<never>[] {
  return [
    createCalendarFindAvailabilityTool() as unknown as ConnectTool<never>,
    createOutlookFindAvailabilityTool() as unknown as ConnectTool<never>,
  ];
}
