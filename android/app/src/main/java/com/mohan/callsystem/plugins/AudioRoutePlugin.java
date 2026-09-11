package com.mohan.callsystem.plugins;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.mohan.callsystem.CallService;

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

    @PluginMethod
    public void startService(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent intent = new Intent(ctx, CallService.class);
            intent.setAction(CallService.ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to start service: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent intent = new Intent(ctx, CallService.class);
            intent.setAction(CallService.ACTION_STOP);
            ctx.startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop service: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void notifyIncoming(PluginCall call) {
        try {
            String callerName = call.getString("callerName", "Someone");
            Context ctx = getContext();
            Intent intent = new Intent(ctx, CallService.class);
            intent.setAction(CallService.ACTION_INCOMING);
            intent.putExtra(CallService.EXTRA_CALLER_NAME, callerName);
            ctx.startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to notify incoming: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void cancelIncoming(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent intent = new Intent(ctx, CallService.class);
            intent.setAction(CallService.ACTION_INCOMING_END);
            ctx.startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to cancel incoming: " + e.getMessage(), e);
        }
    }
}
