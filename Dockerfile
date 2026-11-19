FROM node:20-alpine

# Установка необходимых системных утилит (openssh и sshpass для VDS/SSH мониторинга)
RUN apk add --no-cache openssh-client sshpass iputils ca-certificates tzdata

WORKDIR /app

# Копирование структуры проекта
COPY package.json ./
COPY server.js ./
COPY homenet_monitor.html ./

# Создание директории данных
RUN mkdir -p /app/data

EXPOSE 3001

CMD ["node", "server.js"]
