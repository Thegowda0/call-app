package com.mohan.callsystem.plugins;

import android.content.Context;
import android.media.AudioManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        Boolean on = call.getBoolean("on", false);
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) {
                call.reject("AudioManager unavailable");
                return;
            }
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(on);

            JSObject ret = new JSObject();
            ret.put("speaker", on);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to set audio route: " + e.getMessage(), e);
        }
    }
}
