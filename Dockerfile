# Use a lightweight Node.js base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy dependency manifest files
COPY package*.json ./

# Install dependencies (including devDependencies to allow Vite production compile)
RUN npm install

# Copy the entire workspace code
COPY . .

# Compile optimized static frontend bundles
RUN npm run build

# Expose standard port required by Hugging Face Spaces
EXPOSE 7860

# Define start command
CMD ["node", "server.js"]
