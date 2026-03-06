FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy all app files
COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
