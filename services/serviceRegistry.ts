import { logger } from '@/lib/logger';
import { isFirebaseReady } from '../config/firebase';
import { attendanceService } from './attendanceService';
import { reminderSettingsService } from './reminderSettingsService';

// Service registry to manage service lifecycle
class ServiceRegistry {
  private static instance: ServiceRegistry;
  private services: Map<string, any> = new Map();
  private initPromises: Map<string, Promise<any>> = new Map();

  static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  async getService<T>(serviceName: string, serviceFactory: () => Promise<T> | T): Promise<T> {
    // If service is already initialized, return it
    if (this.services.has(serviceName)) {
      return this.services.get(serviceName);
    }

    // If initialization is in progress, wait for it
    if (this.initPromises.has(serviceName)) {
      return await this.initPromises.get(serviceName);
    }

    // Start initialization
    const initPromise = this.initializeService(serviceName, serviceFactory);
    this.initPromises.set(serviceName, initPromise);

    try {
      const service = await initPromise;
      this.services.set(serviceName, service);
      this.initPromises.delete(serviceName);
      return service;
    } catch (error) {
      this.initPromises.delete(serviceName);
      throw error;
    }
  }

  private async initializeService<T>(serviceName: string, serviceFactory: () => Promise<T> | T): Promise<T> {
    logger.debug(`🔧 ServiceRegistry: Initializing ${serviceName}...`);
    
    // Wait for Firebase to be ready
    let attempts = 0;
    while (!isFirebaseReady() && attempts < 30) {
      logger.debug(`🔧 ServiceRegistry: Waiting for Firebase (attempt ${attempts + 1}/30)...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (!isFirebaseReady()) {
      throw new Error(`Firebase not ready after 30 seconds while initializing ${serviceName}`);
    }

    logger.debug(`🔧 ServiceRegistry: Firebase ready, creating ${serviceName}...`);
    const service = await serviceFactory();
    logger.debug(`🔧 ServiceRegistry: Service factory returned:`, typeof service, service);
    
    if (!service) {
      logger.error(`🔧 ServiceRegistry: Service factory returned null/undefined for ${serviceName}`);
      throw new Error(`Service factory returned null/undefined for ${serviceName}`);
    }
    
    logger.debug(`✅ ServiceRegistry: ${serviceName} initialized successfully`);
    
    return service;
  }
}

export default ServiceRegistry;
