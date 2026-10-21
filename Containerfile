FROM docker.io/library/python:3.13-slim

ENV PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app
COPY board.py game.py server.py ./
COPY static ./static

USER nobody
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["python", "server.py"]
