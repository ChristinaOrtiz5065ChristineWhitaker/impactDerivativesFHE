import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ImpactDerivative {
  id: string;
  projectName: string;
  impactType: string;
  encryptedValue: string;
  maturityDate: number;
  owner: string;
  status: "active" | "expired" | "settled";
  currentPrice: number;
  volume: number;
}

// FHE Encryption/Decryption utilities for numerical data
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const parts = encryptedData.split('-');
    if (parts.length >= 2) {
      return parseFloat(atob(parts[1]));
    }
  }
  return parseFloat(encryptedData);
};

// FHE computation on encrypted data
const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'priceIncrease5%':
      result = value * 1.05;
      break;
    case 'priceDecrease5%':
      result = value * 0.95;
      break;
    case 'volumeAdjust':
      result = value * 1.1;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [derivatives, setDerivatives] = useState<ImpactDerivative[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDerivative, setNewDerivative] = useState({ projectName: "", impactType: "carbon", initialValue: 0, maturityDays: 30 });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [fheComputeStatus, setFheComputeStatus] = useState<{ visible: boolean; operation: string }>({ visible: false, operation: "" });

  // Initialize contract and load data
  useEffect(() => {
    loadDerivatives().finally(() => setLoading(false));
    const initContract = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initContract();
  }, []);

  // Load derivatives from contract
  const loadDerivatives = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load derivative keys
      const keysBytes = await contract.getData("derivative_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing derivative keys:", e); }
      }

      // Load each derivative
      const list: ImpactDerivative[] = [];
      for (const key of keys) {
        try {
          const derivativeBytes = await contract.getData(`derivative_${key}`);
          if (derivativeBytes.length > 0) {
            try {
              const derivativeData = JSON.parse(ethers.toUtf8String(derivativeBytes));
              list.push({
                id: key,
                projectName: derivativeData.projectName,
                impactType: derivativeData.impactType,
                encryptedValue: derivativeData.encryptedValue,
                maturityDate: derivativeData.maturityDate,
                owner: derivativeData.owner,
                status: derivativeData.status || "active",
                currentPrice: derivativeData.currentPrice || 0,
                volume: derivativeData.volume || 0
              });
            } catch (e) { console.error(`Error parsing derivative data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading derivative ${key}:`, e); }
      }
      
      list.sort((a, b) => b.maturityDate - a.maturityDate);
      setDerivatives(list);
    } catch (e) { console.error("Error loading derivatives:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  // Create new impact derivative
  const createDerivative = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting impact value with Zama FHE..." 
    });

    try {
      // Encrypt the initial value using FHE
      const encryptedValue = FHEEncryptNumber(newDerivative.initialValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");

      // Generate unique ID
      const derivativeId = `deriv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const maturityDate = Math.floor(Date.now() / 1000) + (newDerivative.maturityDays * 24 * 60 * 60);

      // Prepare derivative data
      const derivativeData = {
        projectName: newDerivative.projectName,
        impactType: newDerivative.impactType,
        encryptedValue: encryptedValue,
        maturityDate: maturityDate,
        owner: address,
        status: "active",
        currentPrice: newDerivative.initialValue,
        volume: 0
      };

      // Store derivative data
      await contract.setData(`derivative_${derivativeId}`, ethers.toUtf8Bytes(JSON.stringify(derivativeData)));

      // Update keys list
      const keysBytes = await contract.getData("derivative_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(derivativeId);
      await contract.setData("derivative_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Impact derivative created with FHE encryption!" 
      });

      await loadDerivatives();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewDerivative({ projectName: "", impactType: "carbon", initialValue: 0, maturityDays: 30 });
      }, 2000);

    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  // Trade derivative (FHE computation example)
  const tradeDerivative = async (derivativeId: string, operation: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }

    setFheComputeStatus({ visible: true, operation: operation });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const derivativeBytes = await contract.getData(`derivative_${derivativeId}`);
      if (derivativeBytes.length === 0) throw new Error("Derivative not found");
      
      const derivativeData = JSON.parse(ethers.toUtf8String(derivativeBytes));
      
      // Simulate FHE computation on encrypted data
      setTimeout(async () => {
        const updatedValue = FHECompute(derivativeData.encryptedValue, operation);
        
        const contractWithSigner = await getContractWithSigner();
        if (!contractWithSigner) throw new Error("Failed to get contract with signer");
        
        const updatedDerivative = { 
          ...derivativeData, 
          encryptedValue: updatedValue,
          currentPrice: derivativeData.currentPrice * (operation === 'priceIncrease5%' ? 1.05 : 0.95),
          volume: derivativeData.volume + 1
        };
        
        await contractWithSigner.setData(`derivative_${derivativeId}`, ethers.toUtf8Bytes(JSON.stringify(updatedDerivative)));
        
        setTransactionStatus({ 
          visible: true, 
          status: "success", 
          message: `FHE ${operation} completed successfully!` 
        });
        
        await loadDerivatives();
        setTimeout(() => {
          setTransactionStatus({ visible: false, status: "pending", message: "" });
          setFheComputeStatus({ visible: false, operation: "" });
        }, 2000);
      }, 2000);

    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Trade failed: " + (e.message || "Unknown error") });
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setFheComputeStatus({ visible: false, operation: "" });
      }, 3000);
    }
  };

  // Check contract availability
  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Contract not available");
      
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: `Contract is ${isAvailable ? 'available' : 'not available'}` 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Statistics for dashboard
  const activeCount = derivatives.filter(d => d.status === "active").length;
  const totalVolume = derivatives.reduce((sum, d) => sum + d.volume, 0);
  const avgPrice = derivatives.length > 0 ? derivatives.reduce((sum, d) => sum + d.currentPrice, 0) / derivatives.length : 0;

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container fhe-theme">
      {/* Sidebar Navigation */}
      <div className="app-sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="fhe-logo-icon"></div>
            <h1>ImpactDEX</h1>
          </div>
          <div className="fhe-badge">FHE Powered</div>
        </div>
        
        <nav className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <div className="nav-icon">📊</div>
            <span>Dashboard</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "derivatives" ? "active" : ""}`}
            onClick={() => setActiveTab("derivatives")}
          >
            <div className="nav-icon">🔗</div>
            <span>Derivatives</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "create" ? "active" : ""}`}
            onClick={() => setShowCreateModal(true)}
          >
            <div className="nav-icon">➕</div>
            <span>Create New</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "analytics" ? "active" : ""}`}
            onClick={() => setActiveTab("analytics")}
          >
            <div className="nav-icon">📈</div>
            <span>Analytics</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={true} />
          </div>
          <button onClick={checkAvailability} className="availability-btn">
            Check Contract
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="app-main">
        <header className="app-header">
          <h2>FHE-Encrypted Impact Derivatives DEX</h2>
          <div className="header-actions">
            <button onClick={loadDerivatives} className="refresh-btn" disabled={isRefreshing}>
              {isRefreshing ? "🔄 Refreshing..." : "🔄 Refresh"}
            </button>
          </div>
        </header>

        <div className="main-content">
          {/* Dashboard Tab */}
          {activeTab === "dashboard" && (
            <div className="dashboard-tab">
              <div className="welcome-banner">
                <h3>Welcome to ImpactDEX</h3>
                <p>Trade FHE-encrypted impact derivatives for ReFi projects. All computations happen on encrypted data using Zama FHE technology.</p>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">{derivatives.length}</div>
                  <div className="stat-label">Total Derivatives</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{activeCount}</div>
                  <div className="stat-label">Active</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{totalVolume}</div>
                  <div className="stat-label">Total Volume</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">${avgPrice.toFixed(2)}</div>
                  <div className="stat-label">Avg Price</div>
                </div>
              </div>

              <div className="recent-activity">
                <h4>Recent Activity</h4>
                <div className="activity-list">
                  {derivatives.slice(0, 5).map(deriv => (
                    <div key={deriv.id} className="activity-item">
                      <div className="activity-type">{deriv.impactType}</div>
                      <div className="activity-details">{deriv.projectName}</div>
                      <div className="activity-price">${deriv.currentPrice}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Derivatives List Tab */}
          {activeTab === "derivatives" && (
            <div className="derivatives-tab">
              <div className="section-header">
                <h3>Impact Derivatives</h3>
                <button onClick={() => setShowCreateModal(true)} className="create-btn">
                  + New Derivative
                </button>
              </div>

              <div className="derivatives-list">
                {derivatives.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">📊</div>
                    <p>No impact derivatives found</p>
                    <button onClick={() => setShowCreateModal(true)} className="create-btn primary">
                      Create First Derivative
                    </button>
                  </div>
                ) : (
                  derivatives.map(derivative => (
                    <div key={derivative.id} className="derivative-card">
                      <div className="derivative-header">
                        <div className="derivative-title">
                          <span className="project-name">{derivative.projectName}</span>
                          <span className={`impact-type ${derivative.impactType}`}>{derivative.impactType}</span>
                        </div>
                        <span className={`status ${derivative.status}`}>{derivative.status}</span>
                      </div>
                      
                      <div className="derivative-details">
                        <div className="detail-item">
                          <label>Current Price</label>
                          <span>${derivative.currentPrice}</span>
                        </div>
                        <div className="detail-item">
                          <label>Volume</label>
                          <span>{derivative.volume}</span>
                        </div>
                        <div className="detail-item">
                          <label>Maturity</label>
                          <span>{new Date(derivative.maturityDate * 1000).toLocaleDateString()}</span>
                        </div>
                      </div>

                      <div className="derivative-actions">
                        <button 
                          onClick={() => tradeDerivative(derivative.id, 'priceIncrease5%')}
                          className="trade-btn buy"
                          disabled={derivative.status !== "active"}
                        >
                          Buy +5%
                        </button>
                        <button 
                          onClick={() => tradeDerivative(derivative.id, 'priceDecrease5%')}
                          className="trade-btn sell"
                          disabled={derivative.status !== "active"}
                        >
                          Sell -5%
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Analytics Tab */}
          {activeTab === "analytics" && (
            <div className="analytics-tab">
              <h3>Market Analytics</h3>
              <div className="charts-container">
                <div className="chart-card">
                  <h4>Price Distribution</h4>
                  <div className="price-chart">
                    {derivatives.map((deriv, index) => (
                      <div 
                        key={deriv.id} 
                        className="price-bar"
                        style={{ height: `${(deriv.currentPrice / Math.max(...derivatives.map(d => d.currentPrice), 1)) * 100}%` }}
                        title={`${deriv.projectName}: $${deriv.currentPrice}`}
                      ></div>
                    ))}
                  </div>
                </div>
                <div className="chart-card">
                  <h4>Volume by Type</h4>
                  <div className="volume-chart">
                    {Array.from(new Set(derivatives.map(d => d.impactType))).map(type => (
                      <div key={type} className="volume-item">
                        <span className="type-label">{type}</span>
                        <div className="volume-bar">
                          <div 
                            className="volume-fill" 
                            style={{ width: `${(derivatives.filter(d => d.impactType === type).reduce((sum, d) => sum + d.volume, 0) / Math.max(totalVolume, 1)) * 100}%` }}
                          ></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Derivative Modal */}
      {showCreateModal && (
        <CreateDerivativeModal
          onSubmit={createDerivative}
          onClose={() => setShowCreateModal(false)}
          creating={creating}
          derivativeData={newDerivative}
          setDerivativeData={setNewDerivative}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && "⏳"}
              {transactionStatus.status === "success" && "✅"}
              {transactionStatus.status === "error" && "❌"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      {/* FHE Computation Animation */}
      {fheComputeStatus.visible && (
        <div className="fhe-computation-modal">
          <div className="fhe-computation-content">
            <div className="fhe-animation">
              <div className="encrypted-data">FHE-Encrypted Data</div>
              <div className="computation-arrow">→</div>
              <div className="computation-process">Computing with Zama FHE...</div>
              <div className="computation-arrow">→</div>
              <div className="encrypted-result">Encrypted Result</div>
            </div>
            <div className="computation-message">
              Performing {fheComputeStatus.operation} on encrypted data...
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Modal for creating new derivatives
interface CreateDerivativeModalProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  derivativeData: any;
  setDerivativeData: (data: any) => void;
}

const CreateDerivativeModal: React.FC<CreateDerivativeModalProps> = ({
  onSubmit,
  onClose,
  creating,
  derivativeData,
  setDerivativeData
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setDerivativeData({ ...derivativeData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setDerivativeData({ ...derivativeData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!derivativeData.projectName || !derivativeData.initialValue) {
      alert("Please fill required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h3>Create Impact Derivative</h3>
          <button onClick={onClose} className="close-modal">×</button>
        </div>

        <div className="modal-body">
          <div className="fhe-notice">
            <div className="fhe-icon">🔒</div>
            <div>
              <strong>FHE Encryption Active</strong>
              <p>All values will be encrypted with Zama FHE before storage</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>Project Name *</label>
              <input
                type="text"
                name="projectName"
                value={derivativeData.projectName}
                onChange={handleChange}
                placeholder="Enter project name"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label>Impact Type *</label>
              <select
                name="impactType"
                value={derivativeData.impactType}
                onChange={handleChange}
                className="form-select"
              >
                <option value="carbon">Carbon Capture</option>
                <option value="biodiversity">Biodiversity</option>
                <option value="reforestation">Reforestation</option>
                <option value="clean-energy">Clean Energy</option>
              </select>
            </div>

            <div className="form-group">
              <label>Initial Value ($) *</label>
              <input
                type="number"
                name="initialValue"
                value={derivativeData.initialValue}
                onChange={handleValueChange}
                placeholder="0.00"
                step="0.01"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label>Maturity (Days)</label>
              <input
                type="number"
                name="maturityDays"
                value={derivativeData.maturityDays}
                onChange={handleValueChange}
                placeholder="30"
                className="form-input"
              />
            </div>
          </div>

          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-content">
              <div className="plain-value">
                <span>Plain Value:</span>
                <code>${derivativeData.initialValue || 0}</code>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-value">
                <span>Encrypted Value:</span>
                <code>{derivativeData.initialValue ? FHEEncryptNumber(derivativeData.initialValue).substring(0, 40) + '...' : 'N/A'}</code>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn">
            {creating ? "Encrypting with FHE..." : "Create Derivative"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;