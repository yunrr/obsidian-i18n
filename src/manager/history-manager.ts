import { App } from 'obsidian';
import { AutoHistoryItem, AutoTaskItem } from '../views/manager/auto-store';

export class HistoryManager {
    private app: App;
    private historyPath: string;

    constructor(app: App, configPath: string) {
        this.app = app;
        this.historyPath = `${configPath}/auto-history.json`;
    }

    async loadHistory(): Promise<AutoHistoryItem[]> {
        try {
            const adapter = this.app.vault.adapter;
            if (await adapter.exists(this.historyPath)) {
                const data = await adapter.read(this.historyPath);
                return JSON.parse(data);
            }
        } catch (e) {
            console.error('Failed to load auto history:', e);
        }
        return [];
    }

    async saveHistory(history: AutoHistoryItem[]): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            const dir = this.historyPath.split('/').slice(0, -1).join('/');
            if (!(await adapter.exists(dir))) {
                await adapter.mkdir(dir);
            }
            const data = history.slice(0, 50);
            await adapter.write(this.historyPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('Failed to save auto history:', e);
        }
    }

    async addRecord(trigger: AutoHistoryItem['trigger'], tasks: AutoTaskItem[], existingHistory?: AutoHistoryItem[]): Promise<AutoHistoryItem> {
        const history = existingHistory ? [...existingHistory] : await this.loadHistory();

        let success = 0;
        let error = 0;
        let skipped = 0;
        let upToDate = 0;
        let discovered = 0;
        const details: AutoTaskItem[] = [];

        for (const task of tasks) {
            if (task.status === 'success') success++;
            else if (task.status === 'error') error++;
            else if (task.status === 'skipped') skipped++;
            else if (task.status === 'up_to_date') upToDate++;
            else if (task.status === 'discovered_new' || task.status === 'discovered_update') discovered++;

            if (task.status !== 'pending' && task.status !== 'skipped') details.push(task);
        }

        const newItem: AutoHistoryItem = {
            id: Date.now().toString(),
            time: Date.now(),
            trigger,
            summary: {
                total: tasks.length,
                success,
                error,
                skipped,
                discovered,
                upToDate
            },
            details: JSON.stringify(details)
        };

        history.unshift(newItem);
        await this.saveHistory(history);
        return newItem;
    }

    async clear(): Promise<void> {
        await this.saveHistory([]);
    }
}
