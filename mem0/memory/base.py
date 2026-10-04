from abc import ABC, abstractmethod

from mem0.exceptions import ClosedMemoryError


class MemoryBase(ABC):
    def _check_open(self):
        """Raise ClosedMemoryError if close() has released this instance.

        Call this at the start of public operations and inside locked
        persistence sections so use-after-close fails loudly with a typed
        error instead of an AttributeError from a None'd-out handle.
        """
        if getattr(self, "_closed", False):
            raise ClosedMemoryError(
                message="This Memory instance has been closed; operations after close() are not allowed",
                error_code="MEM_CLOSED_001",
            )

    @abstractmethod
    def get(self, memory_id):
        """
        Retrieve a memory by ID.

        Args:
            memory_id (str): ID of the memory to retrieve.

        Returns:
            dict: Retrieved memory.
        """
        pass

    @abstractmethod
    def get_all(self):
        """
        List all memories.

        Returns:
            list: List of all memories.
        """
        pass

    @abstractmethod
    def update(self, memory_id, data):
        """
        Update a memory by ID.

        Args:
            memory_id (str): ID of the memory to update.
            data (str): New content to update the memory with.

        Returns:
            dict: Success message indicating the memory was updated.
        """
        pass

    @abstractmethod
    def delete(self, memory_id):
        """
        Delete a memory by ID.

        Args:
            memory_id (str): ID of the memory to delete.
        """
        pass

    @abstractmethod
    def history(self, memory_id):
        """
        Get the history of changes for a memory by ID.

        Args:
            memory_id (str): ID of the memory to get history for.

        Returns:
            list: List of changes for the memory.
        """
        pass
