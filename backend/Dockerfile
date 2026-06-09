# Place this file inside the backend/ folder
FROM python:3.12-slim
WORKDIR /app

# Install FFmpeg and Deno
RUN apt-get update && apt-get install -y ffmpeg curl unzip \
    && curl -fsSL https://deno.land/install.sh | sh

# Set Deno Paths
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Install Python dependencies
COPY requirements.txt .
RUN pip install -r requirements.txt

# Copy the backend code
COPY . .

# Render provides the PORT environment variable. Default to 10000.
ENV PORT 10000
EXPOSE $PORT

# Start the server
CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT