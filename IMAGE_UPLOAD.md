# Product image uploads

Product images selected with Browse are uploaded to Cloudinary before being added to a product. Configure these backend environment variables and restart the API:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

The API signs uploads server-side. The secret must not be added to the frontend environment. PNG, JPEG, and WebP files up to 5 MB are accepted; the returned HTTPS URL is stored with the product and can be used by connected stores.
