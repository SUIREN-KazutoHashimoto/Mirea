# Supplementary upstream notices

Most notices are copied directly from the exact installed package at build time.
These upstream npm releases omit a standalone license file:

- `saxes@6.0.0`: the unmodified license from [the v6.0.0 source tag](https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE).
- `abstract-logging@2.0.1`: its published README declares the [MIT license](https://jsumners.mit-license.org/). The service was unavailable when checked. The accompanying text is extracted from [that service's MIT template](https://github.com/remy/mit-license/blob/master/licenses/MIT.ejs), with the copyright owner from [its upstream owner record](https://github.com/remy/mit-license/blob/master/users/jsumners.json). The downloaded template, owner record and rendering steps are retained in `abstract-logging-2.0.1.sources.json`. No year has been invented and no upstream script is executed. This is a rendered notice, not a claim to be an unmodified downloaded file.
- `@img/sharp-libvips-linux-x64@1.3.4`: its SHA-512-verified npm tarball contains the LGPL-3.0-or-later declaration, a README listing embedded libraries and their licenses, and `versions.json`, but no standalone license. The generator retains that installed README and version list and adds the unmodified [LGPLv3 text, including the incorporated GPLv3 terms, from SPDX license-list-data v3.27.0](https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/LGPL-3.0-or-later.txt). The GNU direct text endpoints were unavailable. The exact package documents, sources and SHA-256 values are recorded in [the supplement's provenance file](sharp-libvips-linux-x64-1.3.4/sources.json). The source repository's Apache-2.0 license covers its build tooling; it is not substituted for the binary package's LGPL declaration. The upstream table is retained as a declaration and source reference for its embedded libraries, not represented as the full original license of each component.

The generator selects supplementary files by exact package name and version.
Dependency updates require checking the upstream notices again. Do not add
credentials, local paths, or runtime data to this directory.
