package com.suiren.mirea;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name="MireaAppearance")
public final class MireaAppearancePlugin extends Plugin {
    @PluginMethod public void setTheme(PluginCall call){String theme=call.getString("theme","");if(!theme.equals("light")&&!theme.equals("dark")){call.reject("Unknown theme");return;}getActivity().runOnUiThread(()->{if(getActivity() instanceof MainActivity)((MainActivity)getActivity()).applyAppearance(theme);call.resolve();});}
}
