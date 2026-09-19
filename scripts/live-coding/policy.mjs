// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Deny reads by default: /System/Volumes/Data aliases must not bypass isolation.
export function toolPolicy(source, read, write, protectedPaths = []) {
  const runtime = [
    dirname(realpathSync(process.execPath)),
    realpathSync("/Users/rydia/Project/mob.ai/git/moonshort-backend-cdotlock/node_modules"),
    join(source, "node_modules"),
    join(source, "package.json"),
    "/usr/bin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/bin",
    "/sbin",
    "/System/Library",
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
    "/private/etc/localtime",
  ];
  const paths = (values) =>
    values.map((p) => `(subpath ${JSON.stringify(realpathSync(p))})`).join(" ");
  return `(version 1)
(allow default)
(deny network*)
(deny file-read*)
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read* ${paths([...runtime, ...read])})
(deny file-write*)
(allow file-write* ${paths(write)} (literal "/dev/null"))
${protectedPaths.length ? `(deny file-write* ${protectedPaths.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ")})` : ""}
`;
}
