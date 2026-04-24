package me.aquitano.health.infrastructure.logging;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.UnsynchronizedAppenderBase;
import ch.qos.logback.core.encoder.Encoder;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

public final class OpenObserveHttpAppender extends UnsynchronizedAppenderBase<ILoggingEvent> {
    private static final MediaType JSON = MediaType.get("application/json");

    private String url;
    private String authorization;
    private String environment = "local";
    private String service = "aqt-health";
    private Encoder<ILoggingEvent> encoder;
    private OkHttpClient client;

    @Override
    public void start() {
        if (isStarted()) {
            return;
        }
        if (isBlank(url) || isBlank(authorization)) {
            addInfo("OpenObserve HTTP appender disabled because OPENOBSERVE_LOG_URL or OPENOBSERVE_AUTHORIZATION is not set");
            return;
        }
        if (encoder == null) {
            addError("OpenObserve HTTP appender requires an encoder");
            return;
        }
        encoder.setContext(getContext());
        encoder.start();
        client = new OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(2))
            .writeTimeout(Duration.ofSeconds(2))
            .readTimeout(Duration.ofSeconds(5))
            .callTimeout(Duration.ofSeconds(7))
            .build();
        super.start();
    }

    @Override
    public void stop() {
        if (encoder != null) {
            encoder.stop();
        }
        if (client != null) {
            client.dispatcher().executorService().shutdown();
            client.connectionPool().evictAll();
        }
        super.stop();
    }

    @Override
    protected void append(ILoggingEvent event) {
        if (!isStarted()) {
            return;
        }
        String json = new String(encoder.encode(event), StandardCharsets.UTF_8).trim();
        String payload = "[" + addOpenObserveFields(json) + "]";
        Request request = new Request.Builder()
            .url(url)
            .header("Authorization", authorization)
            .header("Content-Type", "application/json")
            .post(RequestBody.create(payload, JSON))
            .build();
        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                addWarn("OpenObserve log delivery failed", e);
            }

            @Override
            public void onResponse(Call call, Response response) {
                try (response) {
                    if (!response.isSuccessful()) {
                        addWarn("OpenObserve log delivery returned HTTP " + response.code());
                    }
                }
            }
        });
    }

    private String addOpenObserveFields(String json) {
        if (!json.endsWith("}")) {
            return json;
        }
        return json.substring(0, json.length() - 1)
            + ",\"service\":\"" + escape(service) + "\""
            + ",\"environment\":\"" + escape(environment) + "\""
            + "}";
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String escape(String value) {
        return value == null
            ? ""
            : value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public void setAuthorization(String authorization) {
        this.authorization = authorization;
    }

    public void setEnvironment(String environment) {
        this.environment = environment;
    }

    public void setService(String service) {
        this.service = service;
    }

    public void setEncoder(Encoder<ILoggingEvent> encoder) {
        this.encoder = encoder;
    }
}
