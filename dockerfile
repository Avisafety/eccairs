# Use the official Node.js 16 image from Docker Hub
FROM node:16-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json (if they exist)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your application code into the container
COPY . .

# Expose port 8080 (or whatever port your app uses)
EXPOSE 8080

# Run the app when the container starts
CMD ["npm", "start"]
