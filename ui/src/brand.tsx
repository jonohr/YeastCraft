// SPDX-License-Identifier: GPL-3.0-only
import { FlaskConical } from "lucide-react";

/** The flask retains its Lucide attribution. */
export default function Brand() {
  return (
    <span className="brand-lockup" role="img" aria-label="YeastCraft">
      <FlaskConical className="brand-flask" aria-hidden="true" />
      <span className="brand-name" aria-hidden="true">
        YeastCraft
      </span>
    </span>
  );
}
