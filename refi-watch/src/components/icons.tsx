const P = { className: "i", viewBox: "0 0 24 24", "aria-hidden": true } as const;

export const IconCheck = () => (
  <svg {...P}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconX = () => (
  <svg {...P}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconDot = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </svg>
);
export const IconRefresh = () => (
  <svg {...P}>
    <path d="M20 11a8 8 0 1 0-2.4 5.7" />
    <path d="M20 4v7h-7" />
  </svg>
);
export const IconInfo = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
export const IconClock = () => (
  <svg {...P}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const IconLock = () => (
  <svg {...P}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
