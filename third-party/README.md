# Supplementary upstream notices

Most notices are copied directly from the exact installed package at build time.
These two upstream npm releases omit a standalone license file:

- `saxes@6.0.0`: the unmodified license from [the v6.0.0 source tag](https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE).
- `abstract-logging@2.0.1`: its published README declares the [MIT license](https://jsumners.mit-license.org/). The service was unavailable when checked. The accompanying text is extracted from [that service's MIT template](https://github.com/remy/mit-license/blob/master/licenses/MIT.ejs), with the copyright owner from [its upstream owner record](https://github.com/remy/mit-license/blob/master/users/jsumners.json). The downloaded template, owner record and rendering steps are retained in `abstract-logging-2.0.1.sources.json`. No year has been invented and no upstream script is executed. This is a rendered notice, not a claim to be an unmodified downloaded file.

The generator selects supplementary files by exact package name and version.
Dependency updates require checking the upstream notices again. Do not add
credentials, local paths, or runtime data to this directory.
