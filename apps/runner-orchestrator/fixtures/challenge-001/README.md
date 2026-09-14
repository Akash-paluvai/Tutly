# Challenge 001 — Fix Product Management

Welcome to your first Tutly full-stack debugging challenge.

In this challenge, you are given a full-stack Node.js and Express product catalog application with an in-memory data store and a simple frontend interface.

The application currently has **3 intentional bugs** in its backend controller. Your goal is to identify and resolve these bugs so that all API contracts and test suites pass.

---

## API Contract Specification

| Method | Endpoint | Scenario | Expected Status | Response Body |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/products` | Retrieve all products | `200 OK` | `[ { "id": "1", "name": "...", "price": 120, "tags": [...] }, ... ]` |
| `POST` | `/api/products` | Valid payload (`tags.length >= 3`) | `201 Created` | `{ "id": "<id>", "name": "...", "price": ..., "tags": [...] }` |
| `POST` | `/api/products` | Invalid payload (`tags` not array or `< 3` tags) | `400 Bad Request` | `{ "error": "At least 3 tags are required" }` |
| `DELETE` | `/api/products/:id` | Product exists | `200 OK` | `{ "message": "Product deleted successfully" }` |
| `DELETE` | `/api/products/:id` | Product does not exist | `404 Not Found` | `{ "error": "Product not found" }` |

---

## The Bugs to Fix

All changes should be made in [`backend/controllers/productController.js`](./backend/controllers/productController.js).

### Bug 1: Product Creation Response
- **Current Behavior**: `POST /api/products` stores the product, but returns status `200` with `{ "success": true }`.
- **Expected Behavior**: Must return status `201 Created` and include the created product object `{ id, name, price, tags }` in the response body.

### Bug 2: Tag Validation
- **Current Behavior**: `POST /api/products` does not validate that `tags` is an array or contains sufficient tags.
- **Expected Behavior**: Ensure `tags` is an array and contains at least 3 items. If fewer than 3 tags are provided, return status `400 Bad Request` with:
  ```json
  {
    "error": "At least 3 tags are required"
  }
  ```

### Bug 3: Product Deletion Scope & 404
- **Current Behavior**: `DELETE /api/products/:id` accidentally wipes out the entire catalog and never checks if the ID exists.
- **Expected Behavior**: 
  1. If the requested `:id` does not exist in inventory, return status `404 Not Found` with:
     ```json
     {
       "error": "Product not found"
     }
     ```
  2. If the product exists, delete **only** that specific product and return status `200 OK` with:
     ```json
     {
       "message": "Product deleted successfully"
     }
     ```

---

## Project Structure

```
challenge-001/
├── README.md
├── package.json
├── backend/
│   ├── server.js                      # Express app entry point
│   ├── controllers/
│   │   └── productController.js       # Buggy controller to fix
│   ├── routes/
│   │   └── productRoutes.js           # Express route definitions
│   └── data/
│       └── products.js                # In-memory store with deterministic IDs
├── frontend/
│   ├── index.html                     # Visual catalog dashboard
│   ├── app.js                         # Frontend client logic
│   └── style.css                      # UI styling
├── tests/
│   └── product.visible.test.js        # Visible tests for candidates
└── __hidden__/
    └── product.hidden.test.js         # Hidden tests for Tutly judge runner
```

---

## Commands & Testing

### 1. Install dependencies
```bash
npm install
```

### 2. Start the application
```bash
npm start
```
Open [http://localhost:3001](http://localhost:3001) to inspect and interact with the catalog in your browser.

### 3. Run visible tests (Candidate verification)
```bash
npm test
# or
npm run test:visible
```

### 4. Run hidden tests (Tutly judge evaluation)
```bash
npm run test:hidden
```

### 5. Run all tests
```bash
npm run test:all
```
