package com.mohan.callsystem;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.mohan.callsystem.plugins.AudioRoutePlugin;

public class MainActivity extends BridgeActivity {

    private static final int REQ_NOTIF = 3001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);

        // Create notification channels early — Kotlin object accessed via INSTANCE
        NotificationHelper.INSTANCE.createChannels(this);

        // Request notification permission on Android 13+
        requestNotificationPermission();

        // Auto-start the foreground service
        startCallService();

        // Handle if the app was launched from an incoming call notification
        Intent intent = getIntent();
        if (intent != null && intent.getBooleanExtra("incoming_call", false)) {
            // WebView picks up pending call via localStorage/session state
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                        this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQ_NOTIF
                );
            }
        }
    }

    private void startCallService() {
        try {
            Intent svc = new Intent(this, CallService.class);
svc.setAction(CallService.ACTION_START); 
           if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svc);
            } else {
                startService(svc);
            }
        } catch (Exception e) {
            // Service start can fail on some OEMs — non-fatal
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Silent handling — UI reflects permission state
    }
}
