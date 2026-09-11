package com.mohan.callsystem;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.mohan.callsystem.plugins.AudioRoutePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
