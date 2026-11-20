/** Usage & Costs page: what is counted, what is not, and the period. */
export const usageEs = {
  'usage.metaTitle': 'Uso y costos · TuGPT',
  'usage.partly': 'Disponible en parte',
  'usage.counts': 'Qué cuenta esta página',
  'usage.recorded': 'Se registra aquí',
  'usage.recordedBody': 'Las llamadas a proveedores de IA que TuGPT registra para su organización, con el número de llamadas, los tokens y, cuando se conoce el precio, el costo.',
  'usage.untracked': 'Aún no se registra',
  'usage.untracked.chat': 'Mensajes de Chat',
  'usage.untracked.images': 'Generación de imágenes',
  'usage.untracked.mcp': 'Uso de herramientas MCP',
  'usage.untrackedNote': 'Nada de esto se cuenta en esta página. Un total de 0 no significa que su equipo no haya usado nada.',
  'usage.window': 'Últimos {days} días: desde el {from} hasta ahora ({to}). El período se mueve con cada carga.',
} as const;

export const usageEn: Record<keyof typeof usageEs, string> = {
  'usage.metaTitle': 'Usage & Costs · TuGPT',
  'usage.partly': 'Partly available',
  'usage.counts': 'What this page counts',
  'usage.recorded': 'Recorded here',
  'usage.recordedBody': 'Calls to AI providers that TuGPT records for your organization, with the number of calls, tokens and, where a price is known, the cost.',
  'usage.untracked': 'Not tracked yet',
  'usage.untracked.chat': 'Chat messages',
  'usage.untracked.images': 'Image generation',
  'usage.untracked.mcp': 'MCP tool use',
  'usage.untrackedNote': 'These are not counted anywhere on this page. A total of 0 does not mean your team used nothing.',
  'usage.window': 'Last {days} days: from {from} up to now ({to}). The period moves each time the page loads.',
};
