# Certificados de red corporativa (opcional)

Si la red de la planta usa un proxy con inspección TLS, copia aquí el certificado raíz de la empresa
(`*.crt`, formato PEM) antes de construir las imágenes. Los Dockerfiles lo agregan al almacén de confianza.
No guardes aquí claves privadas. Los `.crt` de esta carpeta están ignorados por git.
