/*-
 *
 * Hedera Local Node
 *
 * Copyright (C) 2023-2024 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { configDotenv } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';
import path, { join } from 'path';
import yaml from 'js-yaml';
import { LoggerService } from '../services/LoggerService';
import { ServiceLocator } from '../services/ServiceLocator';
import { IState } from './IState';
import { CLIService } from '../services/CLIService';
import { CLIOptions } from '../types/CLIOptions';
import { FileSystemUtils } from '../utils/FileSystemUtils';
import { IOBserver } from '../controller/IObserver';
import { EventType } from '../types/EventType';
import { ConfigurationData } from '../data/ConfigurationData';
import { Configuration } from '../types/NetworkConfiguration';
import originalNodeConfiguration from '../configuration/originalNodeConfiguration.json';
import { DockerService } from '../services/DockerService';
import { APPLICATION_YML_RELATIVE_PATH, NECESSARY_PORTS, OPTIONAL_PORTS } from '../constants';

configDotenv({ path: path.resolve(__dirname, '../../.env') });

/**
 * Represents the initialization state of the application.
 * This state is responsible for setting up the necessary environment variables,
 * configuring node properties, and mirror node properties based on the selected configuration.
 */
export class InitState implements IState{
    /**
     * The logger service used for logging messages.
     */
    private logger: LoggerService;

    /**
     * The observer for the InitState.
     */
    private observer: IOBserver | undefined;

    /**
     * The CLI options for the initialization state.
     */
    private cliOptions: CLIOptions;

    /**
     * Represents the Docker service used by the InitState class.
     */
    private dockerService: DockerService;

    /**
     * The name of the state.
     */
    private stateName: string;
    
    /**
     * Initializes a new instance of the InitState class.
     */
    constructor() {
        this.stateName = InitState.name;
        this.logger = ServiceLocator.Current.get<LoggerService>(LoggerService.name);
        this.cliOptions = ServiceLocator.Current.get<CLIService>(CLIService.name).getCurrentArgv();
        this.dockerService = ServiceLocator.Current.get<DockerService>(DockerService.name);
        this.logger.trace('Initialization State Initialized!', this.stateName);
    }

    /**
     * Subscribes an observer to the state.
     * 
     * @param {IOBserver} observer - The observer to subscribe.
     */
    public subscribe(observer: IOBserver): void {
        this.observer = observer;
    }

    /**
     * Called when the state is started.
     * @returns {Promise<void>} A promise that resolves when the state has started.
     */
    public async onStart(): Promise<void> {
        this.logger.trace('Initialization State Starting...', this.stateName);
        const configurationData = new ConfigurationData().getSelectedConfigurationData(this.cliOptions.network);
        this.logger.info("Making sure that Docker is started and it's correct version...", this.stateName);
        // Check if docker is running and it's the correct version
        const isCorrectDockerComposeVersion = await this.dockerService.isCorrectDockerComposeVersion();
        const isDockerStarted = await this.dockerService.checkDocker();

        const dockerHasEnoughResources = await this.dockerService.checkDockerResources(this.cliOptions.multiNode);

        if (!(isCorrectDockerComposeVersion && isDockerStarted && dockerHasEnoughResources)) {
            this.observer!.update(EventType.UnresolvableError);
            return;
        }

        await this.dockerService.isPortInUse(NECESSARY_PORTS.concat(OPTIONAL_PORTS));

        this.logger.info(`Setting configuration for ${this.cliOptions.network} network with latest images on host ${this.cliOptions.host} with dev mode turned ${this.cliOptions.devMode ? 'on' : 'off'} using ${this.cliOptions.fullMode? 'full': 'turbo'} mode in ${this.cliOptions.multiNode? 'multi' : 'single'} node configuration...`, this.stateName);

        this.prepareWorkDirectory();
        const workDirConfiguration = [
            { key: 'NETWORK_NODE_LOGS_ROOT_PATH', value: join(this.cliOptions.workDir, 'network-logs', 'node') },
            { key: 'APPLICATION_CONFIG_PATH', value: join(this.cliOptions.workDir, 'compose-network', 'network-node', 'data', 'config') },
            { key: 'MIRROR_NODE_CONFIG_PATH', value: this.cliOptions.workDir },
            { key: 'RECORD_PARSER_ROOT_PATH', value: join(this.cliOptions.workDir, 'services','record-parser') },
        ];
        configurationData.envConfiguration = (configurationData.envConfiguration ?? []).concat(workDirConfiguration);
        
        this.configureEnvVariables(configurationData.imageTagConfiguration, configurationData.envConfiguration);
        this.configureNodeProperties(configurationData.nodeConfiguration?.properties);
        this.configureMirrorNodeProperties();

        this.observer!.update(EventType.Finish);
    }

    /**
     * Prepares the work directory.
     * 
     * This method logs the path to the work directory, creates ephemeral directories in the work directory, and defines the source paths for the config directory, the mirror node application YAML file, and the record parser.
     * It creates a map of the source paths to the destination paths in the work directory and copies the files from the source paths to the destination paths.
     * 
     * @private
     * @returns {void}
    */
    private prepareWorkDirectory() {
        this.logger.info(`Local Node Working directory set to ${this.cliOptions.workDir}`, this.stateName);
        FileSystemUtils.createEphemeralDirectories(this.cliOptions.workDir);
        const configDirSource = join(__dirname, '../../compose-network/network-node/data/config/');
        const configPathMirrorNodeSource = join(__dirname, APPLICATION_YML_RELATIVE_PATH);
        const recordParserSource = join(__dirname,'../../src/services/record-parser');

        const configFiles = {
            [configDirSource]: `${this.cliOptions.workDir}/compose-network/network-node/data/config`,
            [configPathMirrorNodeSource]: `${this.cliOptions.workDir}/compose-network/mirror-node/application.yml`,
            [recordParserSource]: `${this.cliOptions.workDir}/services/record-parser`
        };
        FileSystemUtils.copyPaths(configFiles);
    }

    /**
     * Configures the environment variables based on the selected configuration.
     * @param {Array<Configuration>} imageTagConfiguration - The image tag configuration.
     * @param {Array<Configuration> | undefined} envConfiguration - The environment variable configuration.
     */
    private configureEnvVariables(imageTagConfiguration: Array<Configuration>, envConfiguration: Array<Configuration> | undefined): void {
        imageTagConfiguration.forEach(variable => {
            process.env[variable.key] = variable.value;
            this.logger.trace(`Environment variable ${variable.key} will be set to ${variable.value}.`, this.stateName);
        });

        if (!envConfiguration) {
            this.logger.trace('No new environment variables were configured.', this.stateName);
            return;
        }

        envConfiguration!.forEach(variable => {
            process.env[variable.key] = variable.value;
            this.logger.trace(`Environment variable ${variable.key} will be set to ${variable.value}.`, this.stateName);
        });

        const relayLimitsDisabled = !this.cliOptions.limits;
        if (relayLimitsDisabled) {
            process.env.RELAY_HBAR_RATE_LIMIT_TINYBAR = '0';
            process.env.RELAY_HBAR_RATE_LIMIT_DURATION = '0';
            process.env.RELAY_RATE_LIMIT_DISABLED = `${relayLimitsDisabled}`;
            this.logger.info('Hedera JSON-RPC Relay rate limits were disabled.', this.stateName);
        }
        this.logger.info('Needed environment variables were set for this configuration.', this.stateName);
    }

    /**
     * Configures the node properties based on the selected configuration.
     * @param {Array<Configuration> | undefined} nodeConfiguration - The node configuration.
     */
    private configureNodeProperties(nodeConfiguration: Array<Configuration> | undefined): void {
        const propertiesFilePath = join(this.cliOptions.workDir, 'compose-network/network-node/data/config/bootstrap.properties');

        let newProperties = '';
        originalNodeConfiguration.bootsrapProperties.forEach(property => {
            newProperties = newProperties.concat(`${property.key}=${property.value}\n`);
        });

        if (!nodeConfiguration) {
            this.logger.trace('No additional node configuration needed.', this.stateName);
            return;
        }
        nodeConfiguration!.forEach(property => {
            newProperties = newProperties.concat(`${property.key}=${property.value}\n`);
            this.logger.trace(`Bootstrap property ${property.key} will be set to ${property.value}.`, this.stateName);
        });

        writeFileSync(propertiesFilePath, newProperties, { flag: 'w' });

        this.logger.info('Needed bootsrap properties were set for this configuration.', this.stateName);
    }

    /**
     * Configures the mirror node properties.
     * 
     * @private
     */
    // TODO: finish off multi node
    private configureMirrorNodeProperties(): void {
        this.logger.trace('Configuring required mirror node properties, depending on selected configuration...', this.stateName);
        const turboMode = !this.cliOptions.fullMode;
        const debugMode = this.cliOptions.enableDebug;

        const multiNode = this.cliOptions.multiNode;

        const propertiesFilePath = join(this.cliOptions.workDir, 'compose-network/mirror-node/application.yml');
        const application = yaml.load(readFileSync(propertiesFilePath).toString()) as any;

        if (turboMode) {
            application.hedera.mirror.importer.dataPath = originalNodeConfiguration.turboNodeProperties.dataPath;
            application.hedera.mirror.importer.downloader.sources = originalNodeConfiguration.turboNodeProperties.sources;
        }

        if (debugMode) {
            application.hedera.mirror.importer.downloader.local = originalNodeConfiguration.local
        }

        if (multiNode) {
            application['hedera']['mirror']['monitor']['nodes'] = originalNodeConfiguration.multiNodeProperties;
            process.env.RELAY_HEDERA_NETWORK = '{"network-node:50211":"0.0.3","network-node-1:50211":"0.0.4","network-node-2:50211":"0.0.5","network-node-3:50211":"0.0.6"}';
        }

        writeFileSync(propertiesFilePath, yaml.dump(application, { lineWidth: 256 }));
        this.logger.info('Needed mirror node properties were set for this configuration.', this.stateName);
    }
}
