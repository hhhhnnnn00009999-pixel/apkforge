FROM node:20-slim
RUN apt-get update && apt-get install -y openjdk-17-jdk-headless wget unzip zip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js ui.html package.json ./
RUN npm install --production 2>/dev/null || npm install
RUN mkdir -p /opt/android-sdk/platforms/android-34 && wget -q https://github.com/Sable/android-platforms/raw/master/android-34/android.jar -O /opt/android-sdk/platforms/android-34/android.jar || true
ENV ANDROID_JAR=/opt/android-sdk/platforms/android-34/android.jar
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
