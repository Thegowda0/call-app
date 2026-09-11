package com.mohan.callsystem

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class CallService : Service() {

    companion object {
        @Volatile
        var isRunning: Boolean = false
            private set

        const val ACTION_START = "com.mohan.callsystem.START"
        const val ACTION_STOP = "com.mohan.callsystem.STOP"
        const val ACTION_INCOMING = "com.mohan.callsystem.INCOMING"
        const val ACTION_INCOMING_END = "com.mohan.callsystem.INCOMING_END"

        const val EXTRA_CALLER_NAME = "caller_name"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NotificationHelper.createChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                RingtonePlayer.stop(this)
                NotificationHelper.cancelIncomingNotification(this)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                isRunning = false
                return START_NOT_STICKY
            }

            ACTION_INCOMING -> {
                val caller = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "Someone"
                NotificationHelper.showIncomingCallNotification(this, caller)
                RingtonePlayer.start(this)
                return START_STICKY
            }

            ACTION_INCOMING_END -> {
                RingtonePlayer.stop(this)
                NotificationHelper.cancelIncomingNotification(this)
                return START_STICKY
            }

            ACTION_START, null -> {
                startForegroundService()
                isRunning = true
                return START_STICKY
            }
        }
        return START_STICKY
    }

    private fun startForegroundService() {
        val notif = NotificationCompat.Builder(this, NotificationHelper.CHANNEL_ONGOING)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Call System")
            .setContentText("Ready to receive calls")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NotificationHelper.NOTIF_ONGOING_ID,
                    notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NotificationHelper.NOTIF_ONGOING_ID, notif)
            }
        } catch (e: Exception) {
            // startForeground can fail if permission denied — bail out
            stopSelf()
        }
    }

    override fun onDestroy() {
        RingtonePlayer.stop(this)
        NotificationHelper.cancelIncomingNotification(this)
        isRunning = false
        super.onDestroy()
    }
}
