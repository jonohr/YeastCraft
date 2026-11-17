// SPDX-License-Identifier: GPL-3.0-only
import { FlaskConical } from "lucide-react";

/** Original geometric RS lettering; the flask retains its Lucide attribution. */
export default function Brand() {
  return (
    <span className="brand-lockup" role="img" aria-label="Fermentrack RS">
      <FlaskConical className="brand-flask" aria-hidden="true" />
      <span className="brand-name" aria-hidden="true">
        FERMENTRACK
      </span>
      <svg
        className="brand-rs"
        viewBox="0 0 60 28"
        aria-hidden="true"
        focusable="false"
      >
        <g
          transform="translate(6 1) skewX(-12)"
          fill="currentColor"
          fillRule="evenodd"
        >
          <path d="M4 1h14c6 0 9 3 9 8 0 4-3 7-7 8l7 8h-8l-7-8h-1v8H4V1Zm7 5v6h6c2 0 3-1 3-3s-1-3-3-3h-6Z" />
          <path d="M54 1H39c-6 0-9 3-9 7 0 5 3 7 9 8l5 1c2 0 3 1 3 2s-1 1-3 1H30v5h15c6 0 9-3 9-7 0-5-3-7-9-8l-5-1c-2 0-3-1-3-2s1-1 3-1h14V1Z" />
        </g>
      </svg>
    </span>
  );
}
