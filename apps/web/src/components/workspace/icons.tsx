/**
 * Workspace icons: inline, stroke-based, `currentColor`, decorative (aria-hidden). Controls that use
 * them always carry a text label or an aria-label of their own.
 */
const P: Record<string, React.ReactNode> = {
  chat: <><path d="M4 5h16v11H11l-5 3.5V16H4z" /><path d="M8 9.5h8M8 12.5h5" /></>,
  agents: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /><path d="M18.5 4.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" /></>,
  library: <><path d="M4.5 5.5c2.5-1 5-1 7.5.5 2.5-1.5 5-1.5 7.5-.5v13c-2.5-1-5-1-7.5.5-2.5-1.5-5-1.5-7.5-.5z" /><path d="M12 6v13" /></>,
  images: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="9.5" r="1.6" /><path d="M4 17l5-4.5 4 3.5 2.5-2 4.5 3.5" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  clip: <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4L15 7.1" />,
  at: <><circle cx="12" cy="12" r="3.5" /><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7" /></>,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronUp: <path d="M6 14.5l6-6 6 6" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6" /></>,
  logout: <><path d="M14 4.5H6.5v15H14" /><path d="M10.5 12h9M16.5 8.5L20 12l-3.5 3.5" /></>,
  dashboard: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="4.5" rx="1.5" /><rect x="13" y="11" width="7" height="9" rx="1.5" /><rect x="4" y="13.5" width="7" height="6.5" rx="1.5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  file: <><path d="M6.5 3.5h7l4 4v13h-11z" /><path d="M13.5 3.5v4h4" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  tool: <path d="M14.5 5.5a4 4 0 0 0 4.9 5L13 17l-3 3-3.5-.5L6 16l3-3 6.5-6.4a4 4 0 0 0-1-1.1z" />,
  sparkle: <path d="M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2z" />,
  email: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M4 7l8 6 8-6" /></>,
  summarize: <path d="M5 6.5h14M5 10.5h14M5 14.5h9M5 18.5h6" />,
  plan: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4M8 14h3M8 17h6" /></>,
  translate: <><path d="M4 6h9M8.5 4v2M6 6c.6 3 2.6 5.4 5.5 6.5M11 6c-.6 3.2-2.8 6-6 7.5" /><path d="M12.5 20l3.5-8.5 3.5 8.5M13.7 17h4.6" /></>,
  analyze: <><path d="M4 19.5h16" /><path d="M7 16v-4M11 16V8M15 16v-6M19 16V5" /></>,
  write: <><path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z" /><path d="M13.5 7l3 3" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  folderPlus: <><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /></>,
  more: <><circle cx="6" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18" cy="12" r="1.2" /></>,
  pencil: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  archive: <><rect x="3.5" y="4.5" width="17" height="4" rx="1" /><path d="M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10M10 12.5h4" /></>,
  trash: <><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" /><path d="M10 11v5M14 11v5" /></>,
  upload: <><path d="M12 15V4.5M7.5 9L12 4.5 16.5 9" /><path d="M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15" /></>,
  download: <><path d="M12 4.5V15M7.5 10.5L12 15l4.5-4.5" /><path d="M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15" /></>,
  approvals: <><path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  shield: <><path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></>,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4.5M12 17.5v.01" /></>,
  bookOpen: <><path d="M4.5 5.5c2.5-1 5-1 7.5.5 2.5-1.5 5-1.5 7.5-.5v13c-2.5-1-5-1-7.5.5-2.5-1.5-5-1.5-7.5-.5z" /><path d="M12 6v13" /></>,
};
export type IconName = keyof typeof P;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {P[name]}
    </svg>
  );
}
