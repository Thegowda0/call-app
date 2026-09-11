package com.mohan.callsystem

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object NotificationHelper {

    const val CHANNEL_ONGOING = "call_service_ongoing"
    const val CHANNEL_INCOMING = "incoming_calls"

    const val NOTIF_ONGOING_ID = 1001
    const val NOTIF_INCOMING_ID = 1002

    @JvmStatic
    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val ongoing = NotificationChannel(
            CHANNEL_ONGOING,
            "Call System Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps you reachable for incoming calls"
            setShowBadge(false)
            enableVibration(false)
        }
        manager.createNotificationChannel(ongoing)

        val incoming = NotificationChannel(
            CHANNEL_INCOMING,
            "Incoming Calls",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Ringing for incoming calls"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 500, 200, 500, 200, 500)
            val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            val attrs = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build()
            setSound(soundUri, attrs)
            setShowBadge(true)
        }
        manager.createNotificationChannel(incoming)
    }

    @JvmStatic
    fun showOngoingNotification(context: Context, text: String) {
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(context, CHANNEL_ONGOING)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Call System")
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(NOTIF_ONGOING_ID, notif)
        } catch (e: SecurityException) {}
    }

    @JvmStatic
    fun showIncomingCallNotification(context: Context, callerName: String) {
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("incoming_call", true)
        }
        val pending = PendingIntent.getActivity(
            context, 1, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(context, CHANNEL_INCOMING)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Incoming call")
            .setContentText("$callerName is calling you")
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setOngoing(true)
            .setFullScreenIntent(pending, true)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(NOTIF_INCOMING_ID, notif)
        } catch (e: SecurityException) {}
    }

    @JvmStatic
    fun cancelIncomingNotification(context: Context) {
        try {
            NotificationManagerCompat.from(context).cancel(NOTIF_INCOMING_ID)
        } catch (e: Exception) {}
    }
}
