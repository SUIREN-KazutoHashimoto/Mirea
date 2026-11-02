package com.suiren.mirea;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Installs the origin boundary before Bridge starts its first page request. */
@CapacitorPlugin(name = "MireaWebGuard")
public final class MireaWebGuardPlugin extends Plugin {
    @Override public void load() {
        getBridge().setWebViewClient(new MireaWebViewClient(getBridge()));
    }
}
