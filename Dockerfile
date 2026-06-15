FROM nginx:alpine
COPY index.html /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
RUN printf 'server {\n  listen 8080;\n  root /usr/share/nginx/html;\n  index index.html;\n  include /etc/nginx/mime.types;\n  default_type application/octet-stream;\n  types { text/html html; text/css css; application/javascript js mjs; }\n  location = /index.html { add_header Cache-Control "no-cache, must-revalidate"; try_files $uri =404; }\n  location ~* \\.(js|css)$ { add_header Cache-Control "public, max-age=300"; try_files $uri =404; }\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
