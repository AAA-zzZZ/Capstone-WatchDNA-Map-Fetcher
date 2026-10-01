import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import ShopifyGuard from './components/ShopifyGuard';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Uploads from './pages/Uploads';
import UploadDetail from './pages/UploadDetail';
import Scraper from './pages/Scraper';
import HealthStatus from './pages/HealthStatus';
import PremiumStores from './pages/PremiumStores';
import AppAnalytics from './pages/AppAnalytics';
import './styles/App.css';

function App() {
  return (
    <ShopifyGuard>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="uploads" element={<Uploads />} />
            <Route path="uploads/:id" element={<UploadDetail />} />
            <Route path="scraper" element={<Scraper />} />
            <Route path="health" element={<HealthStatus />} />
            <Route path="premium-stores" element={<PremiumStores />} />
            <Route path="app-analytics" element={<AppAnalytics />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
    </ShopifyGuard>
  );
}

export default App;
